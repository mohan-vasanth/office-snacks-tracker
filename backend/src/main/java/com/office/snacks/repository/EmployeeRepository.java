package com.office.snacks.repository;
import com.office.snacks.entity.Employee;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.*;
public interface EmployeeRepository extends JpaRepository<Employee,Long> { List<Employee> findAllByOrderByNameAsc(); boolean existsByNameIgnoreCase(String name); Optional<Employee> findByNameIgnoreCase(String name); }
